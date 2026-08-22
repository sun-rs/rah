import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DeviceAuthGate } from "./components/DeviceAuthGate";
import { installStaleDynamicImportRecovery } from "./lazy-module-reload";
import { ReviewOverlayProvider } from "./inspector/ReviewOverlay";
import "./index.css";
import "./styles.css";

installStaleDynamicImportRecovery();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <DeviceAuthGate>
      <ReviewOverlayProvider>
        <App />
      </ReviewOverlayProvider>
    </DeviceAuthGate>
  </StrictMode>,
);
