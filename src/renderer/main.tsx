import React from "react";
import ReactDOM from "react-dom/client";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isWidgetMode ? <WidgetApp /> : <App />}
  </React.StrictMode>
);
