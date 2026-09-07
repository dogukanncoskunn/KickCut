import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/*
 * One boundary per pane, keyed by tab id in App.tsx, so a crashed screen is
 * reset by switching away and back instead of taking the window with it.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (message: string) => ReactNode },
  { message: string | null }
> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("pane crashed", error, info.componentStack);
  }

  render() {
    if (this.state.message !== null) return this.props.fallback(this.state.message);
    return this.props.children;
  }
}
