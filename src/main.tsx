/* eslint-disable react-refresh/only-export-components */
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { AppBootErrorBoundary, AppBootScreen } from "./AppBoot";
import "./index.css";

const App = lazy(() => import("./App.tsx"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppBootErrorBoundary>
      <Suspense fallback={<AppBootScreen />}>
        <App />
      </Suspense>
    </AppBootErrorBoundary>
  </StrictMode>,
);
