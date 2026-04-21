import React from "react";
import ReactDOM from "react-dom/client";

import App from "./app/App";
import WidgetApp from "./app/WidgetApp";
import "./index.css";

const isWidgetMode = new URLSearchParams(window.location.search).get("mode") === "widget";

if (isWidgetMode) {
  document.documentElement.setAttribute("data-surface", "widget");

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

const renderFatalError = (title: string, detail: string): void => {
  const root = document.getElementById("root");
  if (!root) return;
  const safeTitle = title.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  const safeDetail = detail.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  root.innerHTML = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;background:#0f0e17;color:#f5f3ff;font-family:system-ui,sans-serif;">
      <div style="max-width:720px;width:100%;background:rgba(26,24,40,0.9);border:1px solid rgba(139,92,246,0.3);border-radius:16px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,0.45);">
        <div style="font-size:12px;letter-spacing:0.2em;color:#a78bfa;text-transform:uppercase;">Aura Desktop</div>
        <h1 style="margin:12px 0 16px;font-size:24px;font-weight:700;">${safeTitle}</h1>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#cbd5e1;">
          Something prevented the Aura renderer from starting. Copy the details below and share them with the team so we can fix this.
        </p>
        <pre style="max-height:320px;overflow:auto;background:#0b0a14;border:1px solid rgba(148,163,184,0.2);border-radius:10px;padding:16px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:#fda4af;">${safeDetail}</pre>
        <div style="margin-top:20px;font-size:12px;color:#94a3b8;">Press Ctrl+R to reload, or contact the Aura team with the error above.</div>
      </div>
    </div>
  `;
};

window.addEventListener("error", (event) => {
  const detail = event.error?.stack ?? event.message ?? "Unknown error";
  console.error("[renderer] uncaught error:", detail);
  if (!document.getElementById("root")?.childNodes.length) {
    renderFatalError("Startup error", detail);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error("[renderer] unhandled rejection:", detail);
  if (!document.getElementById("root")?.childNodes.length) {
    renderFatalError("Startup error", detail);
  }
});

try {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Root element '#root' was not found in index.html.");
  }
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {isWidgetMode ? <WidgetApp /> : <App />}
    </React.StrictMode>,
  );
} catch (caught) {
  const detail = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  renderFatalError("Failed to mount Aura", detail);
}
