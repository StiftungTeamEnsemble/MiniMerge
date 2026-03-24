import { Component, StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import "./index.css";

const App = lazy(() => import("./App.tsx"));

function AppBootScreen({
  title = "Loading MiniMerge",
  message = "This can take a moment on first load.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-screen__panel">
        <h1 className="boot-screen__title">{title}</h1>
        <p className="boot-screen__message">{message}</p>
        <div
          className="boot-screen__progress"
          aria-hidden="true"
        >
          <span className="boot-screen__progress-bar" />
        </div>
      </div>
    </div>
  );
}

class AppBootErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <AppBootScreen
          title="MiniMerge could not start"
          message="The PDF engine failed to load. Reload the page to try again."
        />
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppBootErrorBoundary>
      <Suspense fallback={<AppBootScreen />}>
        <App />
      </Suspense>
    </AppBootErrorBoundary>
  </StrictMode>,
);
