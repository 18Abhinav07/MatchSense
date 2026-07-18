import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createPendingActivationStore } from "./features/push/activation-store";
import { navigateFromNotificationActivation } from "./features/push/route-activation";
import { installNotificationActivation } from "./notification-activation";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("MatchSense root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    installNotificationActivation({
      onActivation: navigateFromNotificationActivation,
      origin: window.location.origin,
      pendingStore: createPendingActivationStore(),
      serviceWorker: navigator.serviceWorker,
    });
    void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  });
}
