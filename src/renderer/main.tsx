import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app/App";
import WidgetApp from "./app/WidgetApp";
import "./index.css";

const isWidgetMode = new URLSearchParams(window.location.search).get("mode") === "widget";

if (isWidgetMode) {
  document.documentElement.setAttribute("data-surface", "widget");
  
  // Force absolute transparency to override any rogue CSS chunks or Tailwind base styles
  const style = document.createElement("style");
  style.innerHTML = `
    html, body, #root {
      background: transparent !important;
      background-color: transparent !important;
      box-shadow: none !important;
      isolation: auto !important;
    }
  `;
  document.head.appendChild(style);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Aura renderer root element (#root) was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    {isWidgetMode ? <WidgetApp /> : <App />}
  </StrictMode>
);
