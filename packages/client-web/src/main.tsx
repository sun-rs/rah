import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DeviceAuthGate } from "./components/DeviceAuthGate";
import "./index.css";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <DeviceAuthGate>
      <App />
    </DeviceAuthGate>
  </StrictMode>,
);
